import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixtureEnvironment } from "../../../scripts/e2e-fixtures/fixture-client";
import { LOCAL_SUPABASE_HOST } from "../../../scripts/e2e-fixtures/local-supabase";

// O começo comum dos geradores de fixture E2E: a precedência do ambiente
// (E2E_ENV_PATH, senão .env.e2e, por cima do .env.local) e as recusas.

let dir: string;

const envFile = (name: string, values: Record<string, string>) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
  return file;
};

const complete = (url: string) => ({
  NEXT_PUBLIC_SUPABASE_URL: url,
  SUPABASE_SERVICE_ROLE_KEY: `chave-${new URL(url).hostname}`,
  E2E_COORDINATOR_EMAIL: "coord@example.com",
  E2E_MEMBER_EMAIL: "member@example.com",
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-client-"));
  envFile(".env.local", { NEXT_PUBLIC_SUPABASE_URL: "https://producao.supabase.co" });
  envFile(".env.e2e", complete("http://e2e.example.test"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("fixtureEnvironment", () => {
  it("sem E2E_ENV_PATH, o .env.e2e vence o .env.local", () => {
    expect(fixtureEnvironment({}, {}, dir).url).toBe("http://e2e.example.test");
  });

  it("com E2E_ENV_PATH, o arquivo apontado vence o .env.e2e", () => {
    const local = envFile("local.env", complete("http://127.0.0.1:54321"));
    const environment = fixtureEnvironment({}, { E2E_ENV_PATH: local }, dir);
    expect(environment).toEqual({
      url: "http://127.0.0.1:54321",
      serviceRoleKey: "chave-127.0.0.1",
      coordinatorEmail: "coord@example.com",
      memberEmail: "member@example.com",
    });
  });

  it("localOnly recusa o Supabase que não é local", () => {
    expect(() => fixtureEnvironment({ localOnly: true }, {}, dir)).toThrow(
      /aponta para e2e\.example\.test: esta fixture só é criada no Supabase local/,
    );
    for (const url of ["http://localhost:54321", "http://127.0.0.1:54321"]) {
      const local = envFile("local.env", complete(url));
      expect(fixtureEnvironment({ localOnly: true }, { E2E_ENV_PATH: local }, dir).url).toBe(url);
    }
  });

  it("recusa ambiente sem chave ou sem os e-mails E2E", () => {
    const noKey = envFile("sem-chave.env", { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:1" });
    expect(() => fixtureEnvironment({}, { E2E_ENV_PATH: noKey }, dir)).toThrow(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes",
    );
    const withoutMember: Record<string, string> = complete("http://localhost:1");
    delete withoutMember.E2E_MEMBER_EMAIL;
    const noEmail = envFile("sem-email.env", withoutMember);
    expect(() => fixtureEnvironment({}, { E2E_ENV_PATH: noEmail }, dir)).toThrow(
      /E2E_COORDINATOR_EMAIL \/ E2E_MEMBER_EMAIL ausentes/,
    );
  });
});

// A regra de host local que o gerador de llm-decisions e o spec que consome a
// fixture aplicam: uma só, em `local-supabase.ts`.
describe("LOCAL_SUPABASE_HOST", () => {
  it("aceita localhost e 127.0.0.1, e recusa host remoto ou parecido", () => {
    const local = (url: string) => LOCAL_SUPABASE_HOST.test(new URL(url).hostname);
    expect(local("http://localhost:54321")).toBe(true);
    expect(local("http://127.0.0.1:54321")).toBe(true);
    for (const url of [
      "https://projeto.supabase.co",
      "http://e2e.example.test",
      "http://localhost.example.test:54321",
      "http://127.0.0.1.nip.io:54321",
      "http://127.0.0.2:54321",
    ]) {
      expect(local(url), url).toBe(false);
    }
  });

  it("o spec de llm-decisions usa a mesma regra, sem cópia própria", () => {
    const spec = fs.readFileSync(
      path.join(__dirname, "../../../e2e/llm-decisions.smoke.spec.ts"),
      "utf8",
    );
    expect(spec).toMatch(
      /import \{ LOCAL_SUPABASE_HOST \} from "\.\.\/scripts\/e2e-fixtures\/local-supabase";/,
    );
    expect(spec).not.toMatch(/localhost|127\\?\.0\\?\.0\\?\.1/);
  });
});
