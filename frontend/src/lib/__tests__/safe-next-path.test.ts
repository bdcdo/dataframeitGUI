import { describe, it, expect } from "vitest";
import { safeNextPath } from "@/lib/safe-next-path";

// Regressão do achado da revisão adversarial: o guard antigo `startsWith("/")`
// aceitava destinos protocol-relative ("//evil.com") e vazava um open-redirect
// pós-login. safeNextPath só pode aceitar caminhos internos.
describe("safeNextPath — proteção contra open-redirect via ?next", () => {
  it("aceita caminho interno simples", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
  });

  it("preserva query e hash de caminho interno", () => {
    expect(safeNextPath("/projects/abc?tab=analyze#top")).toBe(
      "/projects/abc?tab=analyze#top",
    );
  });

  it("rejeita protocol-relative (//evil.com) → fallback", () => {
    expect(safeNextPath("//evil.example.com/fake")).toBe("/dashboard");
  });

  it("rejeita backslash protocol-relative (/\\evil.com) → fallback", () => {
    expect(safeNextPath("/\\evil.example.com")).toBe("/dashboard");
  });

  it("rejeita URL absoluta com host → fallback", () => {
    expect(safeNextPath("https://evil.example.com")).toBe("/dashboard");
  });

  it("rejeita esquema não-http (javascript:) → fallback", () => {
    expect(safeNextPath("javascript:alert(1)")).toBe("/dashboard");
  });

  it("undefined/vazio → fallback padrão", () => {
    expect(safeNextPath(undefined)).toBe("/dashboard");
    expect(safeNextPath("")).toBe("/dashboard");
  });

  it("respeita fallback customizado", () => {
    expect(safeNextPath("//evil.com", "/inicio")).toBe("/inicio");
  });
});
