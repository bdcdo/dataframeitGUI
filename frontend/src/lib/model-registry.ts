export type Provider = "google_genai" | "openai" | "anthropic";

export interface ModelCapabilities {
  provider: Provider;
  model: string;
  label: string;
  supportsTemperature: boolean;
  supportsThinkingLevel: boolean;
  category: "standard" | "reasoning";
}

export const MODEL_REGISTRY: ModelCapabilities[] = [
  // --- Google GenAI ---
  {
    provider: "google_genai",
    model: "gemini-3-flash",
    label: "Gemini 3 Flash",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "google_genai",
    model: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "google_genai",
    model: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "google_genai",
    model: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "google_genai",
    model: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    supportsTemperature: true,
    supportsThinkingLevel: false,
    category: "standard",
  },

  // --- OpenAI ---
  {
    provider: "openai",
    model: "gpt-5.4",
    label: "GPT-5.4",
    supportsTemperature: false,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "openai",
    model: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    supportsTemperature: false,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "openai",
    model: "gpt-4.1",
    label: "GPT-4.1",
    supportsTemperature: true,
    supportsThinkingLevel: false,
    category: "standard",
  },
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    supportsTemperature: true,
    supportsThinkingLevel: false,
    category: "standard",
  },
  {
    provider: "openai",
    model: "o3",
    label: "o3",
    supportsTemperature: false,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "openai",
    model: "o4-mini",
    label: "o4-mini",
    supportsTemperature: false,
    supportsThinkingLevel: true,
    category: "reasoning",
  },

  // --- Anthropic ---
  {
    provider: "anthropic",
    model: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
];

export function getModelsForProvider(provider: Provider): ModelCapabilities[] {
  return MODEL_REGISTRY.filter((m) => m.provider === provider);
}

const DEFAULT_CAPABILITIES: Omit<ModelCapabilities, "provider" | "model"> = {
  label: "",
  supportsTemperature: true,
  supportsThinkingLevel: false,
  category: "standard",
};

export function getModelCapabilities(
  provider: Provider,
  model: string
): ModelCapabilities {
  const found = MODEL_REGISTRY.find(
    (m) => m.provider === provider && m.model === model
  );
  if (found) return found;
  return { ...DEFAULT_CAPABILITIES, provider, model, label: model };
}

const PROVIDER_LABELS: Record<Provider, string> = {
  google_genai: "Google GenAI",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export function getProviderLabel(provider: Provider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

const KNOWN_PROVIDERS = new Set<string>(Object.keys(PROVIDER_LABELS));

/**
 * Checks whether a respondent name belongs to an LLM by looking at the
 * "provider/model" prefix instead of merely testing for "/". A human name
 * that happens to contain "/" (e.g. "Ana/Bruno") is not misclassified.
 */
export function isLlmRespondent(respondentName: string): boolean {
  const slash = respondentName.indexOf("/");
  if (slash <= 0) return false;
  return KNOWN_PROVIDERS.has(respondentName.slice(0, slash));
}

/**
 * Converts "google_genai/gemini-2.5-flash" → "Gemini 2.5 Flash"
 * Falls back to the raw model name if not found in registry.
 */
export function formatModelLabel(respondentName: string): string {
  const parts = respondentName.split("/");
  if (parts.length !== 2) return respondentName;
  const [provider, model] = parts;
  const found = MODEL_REGISTRY.find(
    (m) => m.provider === provider && m.model === model
  );
  return found?.label ?? model;
}
