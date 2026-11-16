import { describe, expect, it } from "vitest";
import { LINKED_CLAIMS, sessionTokenWith } from "@/test-utils/session-token";
import { readSessionTokenClaims } from "../clerk-supabase-uid";

describe("readSessionTokenClaims", () => {
  it("lê os claims do payload", () => {
    expect(readSessionTokenClaims(sessionTokenWith(LINKED_CLAIMS))).toEqual(
      LINKED_CLAIMS,
    );
  });

  it("decodifica base64url e UTF-8 (payload com `-`/`_` e acento)", () => {
    // "ÿ¿ão?>" força os caracteres 62/63 do alfabeto, que em base64url são `-`
    // e `_`; `atob` puro os rejeita e devolveria Latin-1 no lugar do acento.
    const claims = { ...LINKED_CLAIMS, nome: "ÿ¿ão?>~~~" };
    const token = sessionTokenWith(claims);
    expect(token.split(".")[1]).toMatch(/[-_]/);
    expect(readSessionTokenClaims(token)).toEqual(claims);
  });

  it.each([
    ["texto sem pontos", "tok"],
    ["payload que não é base64", "a.%%%.c"],
    ["payload que não é JSON", `a.${Buffer.from("nao-json").toString("base64url")}.c`],
    ["JSON que não é objeto", `a.${Buffer.from("null").toString("base64url")}.c`],
  ])("devolve null para %s", (_caso, token) => {
    expect(readSessionTokenClaims(token)).toBeNull();
  });
});
