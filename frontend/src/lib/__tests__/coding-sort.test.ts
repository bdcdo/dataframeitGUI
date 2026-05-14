import { describe, it, expect } from "vitest";
import { sortByRecent } from "@/lib/coding-sort";

const ids = (docs: { id: string }[]) => docs.map((d) => d.id);

describe("sortByRecent", () => {
  it("ordena documentos codificados do mais recente para o mais antigo", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const codedAt = {
      a: "2026-05-14T10:00:00.000Z",
      b: "2026-05-14T12:00:00.000Z",
      c: "2026-05-14T11:00:00.000Z",
    };
    expect(ids(sortByRecent(docs, codedAt))).toEqual(["b", "c", "a"]);
  });

  it("manda documentos nao codificados para o fim", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const codedAt = { b: "2026-05-14T12:00:00.000Z" };
    expect(ids(sortByRecent(docs, codedAt))).toEqual(["b", "a", "c"]);
  });

  it("preserva a ordem original entre documentos nao codificados", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const codedAt = { c: "2026-05-14T12:00:00.000Z" };
    expect(ids(sortByRecent(docs, codedAt))).toEqual(["c", "a", "b", "d"]);
  });

  it("desempata timestamps iguais pela ordem original", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const ts = "2026-05-14T12:00:00.000Z";
    const codedAt = { a: ts, b: ts, c: ts };
    expect(ids(sortByRecent(docs, codedAt))).toEqual(["a", "b", "c"]);
  });

  it("retorna a ordem original quando nada foi codificado", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(ids(sortByRecent(docs, {}))).toEqual(["a", "b", "c"]);
  });

  it("nao muta o array de entrada", () => {
    const docs = [{ id: "a" }, { id: "b" }];
    const codedAt = { b: "2026-05-14T12:00:00.000Z" };
    sortByRecent(docs, codedAt);
    expect(ids(docs)).toEqual(["a", "b"]);
  });
});
