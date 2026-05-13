import { describe, it, expect } from "vitest";
import { applyFieldOrder, reorderFullList } from "@/lib/field-order";
import type { PydanticField } from "@/lib/types";

function f(name: string): PydanticField {
  return {
    name,
    type: "text",
    options: null,
    description: name,
  };
}

describe("applyFieldOrder", () => {
  it("retorna identidade quando order e null", () => {
    const fields = [f("a"), f("b"), f("c")];
    expect(applyFieldOrder(fields, null).map((x) => x.name)).toEqual(["a", "b", "c"]);
  });

  it("retorna identidade quando order e vazio", () => {
    const fields = [f("a"), f("b"), f("c")];
    expect(applyFieldOrder(fields, []).map((x) => x.name)).toEqual(["a", "b", "c"]);
  });

  it("aplica ordem custom completa", () => {
    const fields = [f("a"), f("b"), f("c")];
    expect(applyFieldOrder(fields, ["c", "a", "b"]).map((x) => x.name)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("manda campos novos para o fim", () => {
    const fields = [f("a"), f("b"), f("c")];
    expect(applyFieldOrder(fields, ["a"]).map((x) => x.name)).toEqual(["a", "b", "c"]);
  });

  it("descarta nomes em order que sumiram de fields", () => {
    const fields = [f("a"), f("b")];
    expect(applyFieldOrder(fields, ["x", "a"]).map((x) => x.name)).toEqual(["a", "b"]);
  });

  it("descarta nomes duplicados em order", () => {
    const fields = [f("a"), f("b")];
    expect(applyFieldOrder(fields, ["a", "a", "b"]).map((x) => x.name)).toEqual(["a", "b"]);
  });

  it("e idempotente", () => {
    const fields = [f("a"), f("b"), f("c")];
    const first = applyFieldOrder(fields, ["c", "a"]);
    const second = applyFieldOrder(first, first.map((x) => x.name));
    expect(second.map((x) => x.name)).toEqual(first.map((x) => x.name));
  });

  it("nao muta o array original", () => {
    const fields = [f("a"), f("b"), f("c")];
    const original = fields.map((x) => x.name);
    applyFieldOrder(fields, ["c", "b", "a"]);
    expect(fields.map((x) => x.name)).toEqual(original);
  });
});

describe("reorderFullList", () => {
  it("e equivalente a arrayMove quando todos sao visiveis", () => {
    const full = ["a", "b", "c", "d"];
    const visible = ["a", "b", "c", "d"];
    expect(reorderFullList(full, visible, 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("preserva posicao de campo invisivel no meio", () => {
    const full = ["a", "b", "c", "d"];
    const visible = ["a", "b", "d"];
    // mover 'a' (idx 0 visivel) para idx 2 visivel -> visivel passa a ser ["b","d","a"]
    // full reconstituido: posicoes visiveis (0,1,3) recebem em ordem; (2) "c" intacto.
    expect(reorderFullList(full, visible, 0, 2)).toEqual(["b", "d", "c", "a"]);
  });

  it("retorna copia quando from === to", () => {
    const full = ["a", "b", "c"];
    expect(reorderFullList(full, ["a", "b", "c"], 1, 1)).toEqual(full);
  });

  it("retorna copia em indices invalidos", () => {
    const full = ["a", "b", "c"];
    expect(reorderFullList(full, ["a", "b", "c"], -1, 0)).toEqual(full);
    expect(reorderFullList(full, ["a", "b", "c"], 0, 99)).toEqual(full);
  });

  it("varios invisiveis intercalados", () => {
    const full = ["i1", "a", "i2", "b", "c", "i3"];
    const visible = ["a", "b", "c"];
    // mover c para o inicio dos visiveis: nova ordem visivel ["c","a","b"]
    // posicoes visiveis em full sao 1,3,4 -> ficam c,a,b; invisiveis ficam.
    expect(reorderFullList(full, visible, 2, 0)).toEqual(["i1", "c", "i2", "a", "b", "i3"]);
  });
});
