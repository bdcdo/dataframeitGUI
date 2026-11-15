import { describe, expect, it } from "vitest";
import { stripLikePython } from "@/lib/pydantic-field";
import { generatePydanticCode } from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";

// Os textos do schema atravessam duas linguagens: o gerador os escreve em
// literais Python, e `compile_pydantic` os lê de volta com `str.strip()`. O
// round-trip completo é provado em schema-roundtrip.property.test.ts; aqui
// ficam os casos de regressão nomeados (#525).

const field = (over: Partial<PydanticField>): PydanticField => ({
  id: "00000000-0000-4000-8000-000000000525",
  name: "q",
  type: "text",
  options: null,
  description: "Pergunta",
  ...over,
});

describe("stripLikePython", () => {
  // Os brancos em que `trim()` e `str.strip()` discordavam.
  it.each(["\x1c", "\x1d", "\x1e", "\x1f", "\x85"])(
    "remove %j das bordas, como o Python (o trim() do JS mantinha)",
    (ch) => {
      expect(stripLikePython(`${ch} abc ${ch}`)).toBe("abc");
    },
  );

  it("mantém \\ufeff, que o Python não considera branco (o trim() do JS removia)", () => {
    expect(stripLikePython("﻿abc﻿")).toBe("﻿abc﻿");
  });

  it("remove os brancos comuns e mantém os internos", () => {
    expect(stripLikePython(" \t\n\r\v\f 　a \x1f b ")).toBe("a \x1f b");
    expect(stripLikePython(" \x85 ")).toBe("");
  });
});

describe("generatePydanticCode — textos", () => {
  it("escapa o NUL, que o Python não aceita cru no código", () => {
    const code = generatePydanticCode([field({ description: "a\x00b" })]);
    expect(code).not.toContain("\x00");
    expect(code).toContain('description="a\\x00b"');
  });

  it("apara help_text como o Python, para o sufixo da description não acumular", () => {
    const code = generatePydanticCode([field({ help_text: "Leia\x1f" })]);
    expect(code).toContain('description="Pergunta. Instrucoes: Leia"');
    expect(code).toContain('"help_text": "Leia"');
  });

  it("não apara \\ufeff de justification_prompt, que o Python devolveria", () => {
    const code = generatePydanticCode([
      field({ target: "llm_only", justification_prompt: "﻿" }),
    ]);
    expect(code).toContain('"justification_prompt": "﻿"');
  });
});
