"use client";

import { useState } from "react";
import type { LlmConfig, PydanticField } from "@/lib/types";
import { PromptCard } from "./PromptCard";
import { ModelConfigCard } from "./ModelConfigCard";
import { RunCard } from "./RunCard";

interface LlmConfigurePaneProps {
  projectId: string;
  promptTemplate: string;
  projectDescription: string;
  config: LlmConfig;
  pydanticFields: PydanticField[] | null;
  pydanticCode: string | null;
  totalDocs: number;
  docsWithLlm: number;
}

/**
 * Orquestração fina das três áreas da aba "Configurar LLM": prompt, modelo e
 * execução. Mantém apenas `prompt` e `config` — os dois estados compartilhados
 * pelo "salvar-antes-de-rodar" (`RunCard` persiste ambos antes de disparar a
 * run; `PromptCard`/`ModelConfigCard` os editam). Todo o resto do estado (e os
 * effects de preview, polling e contagem) vive co-localizado em cada card.
 */
export function LlmConfigurePane({
  projectId,
  promptTemplate: initialPrompt,
  projectDescription,
  config: initialConfig,
  pydanticFields,
  pydanticCode,
  totalDocs,
  docsWithLlm,
}: LlmConfigurePaneProps) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [config, setConfig] = useState<LlmConfig>(initialConfig);

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <PromptCard
        projectId={projectId}
        prompt={prompt}
        setPrompt={setPrompt}
        projectDescription={projectDescription}
      />
      <ModelConfigCard
        projectId={projectId}
        config={config}
        setConfig={setConfig}
        pydanticFields={pydanticFields}
      />
      <RunCard
        projectId={projectId}
        config={config}
        prompt={prompt}
        pydanticCode={pydanticCode}
        totalDocs={totalDocs}
        docsWithLlm={docsWithLlm}
      />
    </div>
  );
}
