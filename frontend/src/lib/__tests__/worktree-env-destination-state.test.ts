import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDestination } from "../../../scripts/worktree-env/destination-state.mjs";

// A classificação decide se o bootstrap cria, ignora, refaz ou recusa. Testada
// aqui diretamente — sem subprocesso — porque cada estado corresponde a uma
// situação real do parque de worktrees, e "relink" em particular é o que
// permite CONSERTAR uma worktree cujo alvo foi removido.
describe("classifyDestination", () => {
  let root: string;
  let source: string;
  let destination: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "destination-state-"));
    mkdirSync(join(root, "fonte"), { recursive: true });
    mkdirSync(join(root, "worktree"), { recursive: true });
    source = join(root, "fonte", ".env.local");
    destination = join(root, "worktree", ".env.local");
    writeFileSync(source, "X=1\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("missing — destino não existe", () => {
    expect(classifyDestination(destination, source)).toBe("missing");
  });

  it("linked — symlink já aponta para a fonte", () => {
    symlinkSync(source, destination);
    expect(classifyDestination(destination, source)).toBe("linked");
  });

  it("linked — caminho diferente que resolve para o mesmo arquivo", () => {
    // O link chega à fonte por um diretório symlinkado: já está provisionado, e
    // recriá-lo seria trabalho inútil a cada post-checkout.
    const alias = join(root, "alias");
    symlinkSync(join(root, "fonte"), alias);
    symlinkSync(join(alias, ".env.local"), destination);

    expect(classifyDestination(destination, source)).toBe("linked");
  });

  it("relink — symlink pendente, alvo removido", () => {
    const removed = join(root, "removida", ".env.local");
    symlinkSync(removed, destination);

    expect(classifyDestination(destination, source)).toBe("relink");
  });

  it("relink — symlink para outra fonte existente", () => {
    const other = join(root, "outra.env");
    writeFileSync(other, "X=2\n");
    symlinkSync(other, destination);

    expect(classifyDestination(destination, source)).toBe("relink");
  });

  it("occupied — arquivo real, que nunca pode ser sobrescrito", () => {
    writeFileSync(destination, "X=3\n");
    expect(classifyDestination(destination, source)).toBe("occupied");
  });

  it("occupied — diretório no lugar do arquivo", () => {
    mkdirSync(destination);
    expect(classifyDestination(destination, source)).toBe("occupied");
  });
});
