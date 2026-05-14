import { describe, it, expect } from "vitest";
import { isLlmRespondent } from "@/lib/model-registry";

describe("isLlmRespondent", () => {
  it("detects LLM respondents by known provider prefix", () => {
    expect(isLlmRespondent("google_genai/gemini-2.5-flash")).toBe(true);
    expect(isLlmRespondent("openai/gpt-5.4")).toBe(true);
    expect(isLlmRespondent("anthropic/claude-opus-4-6")).toBe(true);
  });

  it("does not misclassify humans whose name contains a slash", () => {
    expect(isLlmRespondent("Ana/Bruno")).toBe(false);
  });

  it("treats names without a slash as humans", () => {
    expect(isLlmRespondent("Bruno")).toBe(false);
    expect(isLlmRespondent("")).toBe(false);
  });

  it("rejects unknown providers and leading-slash names", () => {
    expect(isLlmRespondent("unknown/some-model")).toBe(false);
    expect(isLlmRespondent("/gemini-2.5-flash")).toBe(false);
  });
});
