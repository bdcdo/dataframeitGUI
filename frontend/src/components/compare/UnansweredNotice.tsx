"use client";

import { useMemo } from "react";

interface UnansweredResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  respondent_id: string | null;
  answer: unknown;
  isFieldStale: boolean;
}

// "Não preencheu este campo" (issue #247, ponto 3): respostas sem valor para
// o campo atual ficam fora dos cards (que só mostram quem respondeu), o que
// fazia parecer que "só o robô respondeu". Listamos quem deixou o campo em
// branco para o revisor entender a ausência. Três filtros:
//  - `answer === undefined`: o campo está vazio (complementar ao `!== undefined`
//    que os cards/stats usam para contar quem respondeu);
//  - `!isFieldStale`: só contam respondentes cujo schema TINHA este campo e
//    ainda assim não o preencheram — não respondentes de um schema antigo onde
//    o campo nem existia (ruído de versão, não uma omissão real);
//  - `respondent_type === "humano"`: a issue é sobre humanos sumindo da tela; um
//    LLM pode omitir um campo legitimamente (ex.: condicional não satisfeita),
//    então "Robô não preencheu" seria ruído.
// Deduplicamos por `respondent_id ?? id` — mesma chave que a contagem da página
// (page.tsx) — para que um respondente com duas respostas qualificadas em branco
// (dados legados / re-codificação) conte e apareça uma vez só, sem fundir
// anônimos distintos (respondent_id null cai no id, que é único por linha).
function listUnansweredHumans(
  responses: UnansweredResponse[],
): { name: string }[] {
  const seen = new Set<string>();
  const out: { name: string }[] = [];
  for (const r of responses) {
    if (
      r.answer !== undefined ||
      r.isFieldStale ||
      r.respondent_type !== "humano"
    )
      continue;
    const key = r.respondent_id ?? r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: r.respondent_name });
  }
  return out;
}

export function UnansweredNotice({
  responses,
}: {
  responses: UnansweredResponse[];
}) {
  const unanswered = useMemo(() => listUnansweredHumans(responses), [responses]);

  if (unanswered.length === 0) return null;

  return (
    <div className="mt-2 rounded-md border border-dashed border-muted-foreground/20 bg-muted/30 px-2.5 py-1.5 text-[11px] leading-tight text-muted-foreground">
      {unanswered.length === 1
        ? "1 respondente não preencheu este campo"
        : `${unanswered.length} respondentes não preencheram este campo`}
      : {unanswered.map((r) => r.name).join(", ")}
    </div>
  );
}
