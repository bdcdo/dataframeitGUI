import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateFieldId } from "@/lib/pydantic-field";

// A identidade de campo da #473 é validada em três fronteiras que NÃO conversam
// entre si: `z.uuid()` no contrato do frontend, a regex da CHECK
// `projects_pydantic_fields_shape` no Postgres e `_parse_field_id` no
// compilador Python. Todas exigem UUID canônico — então o gerador não pode ter
// um ramo que produza outra coisa. E ele tem três: `randomUUID`, o fallback por
// `getRandomValues` e o fallback final. Os dois últimos só rodam fora de secure
// context (dev server alcançado por IP em http puro), que é exatamente onde o
// CI nunca olha — mesmo motivo pelo qual `makeId` ganhou este teste em
// `utils.test.ts`.
describe("generateFieldId", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Canônico de verdade: 8-4-4-4-12 minúsculo, versão 4 e variante RFC 4122.
  // Uma regex de comprimento (`/^[0-9a-f-]{36}$/`) aceitaria 36 hífens e
  // deixaria passar justamente o erro que os fallbacks podem cometer.
  const expectCanonicalV4 = (id: string): void => {
    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  };

  it("usa randomUUID quando o contexto é seguro", () => {
    const native = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    vi.stubGlobal("crypto", { randomUUID: () => native });
    expect(generateFieldId()).toBe(native);
  });

  it("monta um v4 canônico por getRandomValues sem randomUUID", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xff);
        return bytes;
      },
    });
    // Todos os bits em 1 é o caso que denuncia o carimbo de versão/variante: se
    // as máscaras estiverem erradas, sai "ffff...", que falha em toda fronteira.
    expectCanonicalV4(generateFieldId());
  });

  it("mantém a forma canônica quando crypto inteiro está ausente", () => {
    vi.stubGlobal("crypto", undefined);
    expectCanonicalV4(generateFieldId());
  });

  it("carimba versão e variante mesmo com bytes todos zerados", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0x00),
    });
    // O espelho do teste acima: 0x00 e 0xff são os dois extremos em que uma
    // máscara trocada (`&` por `|`, nibble errado) deixa de aparecer.
    expectCanonicalV4(generateFieldId());
  });

  it("não repete o id entre chamadas em nenhum dos fallbacks", () => {
    vi.stubGlobal("crypto", undefined);
    const ids = new Set(Array.from({ length: 50 }, () => generateFieldId()));
    expect(ids.size).toBe(50);
  });
});
