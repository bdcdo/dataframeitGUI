import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PYDANTIC_RESERVED_NAMES,
  PYTHON_KEYWORDS,
  pydanticFieldNameIssue,
} from "@/lib/pydantic-field";

// Contrato com o backend, no mesmo formato de `field_hash_parity_cases.json`:
// o arquivo é a cópia das listas daqui que `backend/tests/test_field_names.py`
// confere contra o `compile_pydantic` real — os nomes listados não compilam, e
// todo outro candidato (palavra-chave leve, atributo do BaseModel) compila.
// Mudou a lista aqui, atualize o arquivo; mudou o que o backend recusa, a suíte
// de lá reprova (#525).
interface ReservedFieldNames {
  python_keywords: string[];
  pydantic_reserved: string[];
  private_examples: string[];
}

const RESERVED = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../backend/tests/reserved_field_names.json", import.meta.url),
    ),
    "utf8",
  ),
) as ReservedFieldNames;

describe("nomes que o código gerado não compila: paridade com o backend", () => {
  it("as listas são as do arquivo que o backend confere", () => {
    expect([...PYTHON_KEYWORDS]).toEqual(RESERVED.python_keywords);
    expect([...PYDANTIC_RESERVED_NAMES]).toEqual(RESERVED.pydantic_reserved);
  });

  it("cada nome do arquivo é recusado pelo motivo certo", () => {
    for (const name of RESERVED.python_keywords) {
      expect(pydanticFieldNameIssue(name), name).toBe("keyword");
    }
    for (const name of RESERVED.pydantic_reserved) {
      expect(pydanticFieldNameIssue(name), name).toBe("pydantic");
    }
    for (const name of RESERVED.private_examples) {
      expect(pydanticFieldNameIssue(name), name).toBe("private");
    }
  });
});
