import { afterEach, describe, expect, it } from "vitest";
import { isLlmEnabled } from "@/lib/feature-flags";

const originalValue = process.env.NEXT_PUBLIC_LLM_ENABLED;

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.NEXT_PUBLIC_LLM_ENABLED;
  } else {
    process.env.NEXT_PUBLIC_LLM_ENABLED = originalValue;
  }
});

describe("isLlmEnabled", () => {
  it("mantém LLM ligado quando a variável não está definida", () => {
    delete process.env.NEXT_PUBLIC_LLM_ENABLED;
    expect(isLlmEnabled()).toBe(true);
  });

  it("desliga LLM somente com o valor explícito false", () => {
    process.env.NEXT_PUBLIC_LLM_ENABLED = "false";
    expect(isLlmEnabled()).toBe(false);
  });
});
