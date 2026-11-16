import { describe, expect, it } from "vitest";
import { uniqueIndexViolations } from "@/lib/unique-index-violations";

type Row = { id: string; a: string | null; b: string | null };
const key = (r: Row) => [r.a, r.b];

describe("uniqueIndexViolations", () => {
  it("devolve só as chaves com mais de uma linha, na ordem de chegada", () => {
    expect(
      uniqueIndexViolations<Row>(
        [
          { id: "1", a: "x", b: "y" },
          { id: "2", a: "x", b: "z" },
          { id: "3", a: "x", b: "y" },
        ],
        key,
        "linhas",
      ),
    ).toEqual([{ key: "x|y", detail: "2 linhas: 1, 3" }]);
  });

  it("não agrupa linha com NULL em qualquer coluna da chave (NULLS DISTINCT)", () => {
    expect(
      uniqueIndexViolations<Row>(
        [
          { id: "1", a: null, b: "y" },
          { id: "2", a: null, b: "y" },
          { id: "3", a: "x", b: null },
          { id: "4", a: "x", b: null },
        ],
        key,
        "linhas",
      ),
    ).toEqual([]);
  });
});
