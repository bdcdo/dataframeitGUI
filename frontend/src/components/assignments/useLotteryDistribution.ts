"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import type { LotteryBalancing, LotteryMode } from "@/lib/lottery-utils";

export interface LotteryDistribution {
  type: "codificacao" | "comparacao";
  setType: Dispatch<SetStateAction<"codificacao" | "comparacao">>;
  isComparacao: boolean;
  researchersPerDoc: number;
  setResearchersPerDoc: Dispatch<SetStateAction<number>>;
  docsPerResearcherEnabled: boolean;
  setDocsPerResearcherEnabled: Dispatch<SetStateAction<boolean>>;
  docsPerResearcher: number;
  setDocsPerResearcher: Dispatch<SetStateAction<number>>;
  docSubsetEnabled: boolean;
  setDocSubsetEnabled: Dispatch<SetStateAction<boolean>>;
  docSubsetSize: number;
  setDocSubsetSize: Dispatch<SetStateAction<number>>;
  balancing: LotteryBalancing;
  setBalancing: Dispatch<SetStateAction<LotteryBalancing>>;
  mode: LotteryMode;
  setMode: Dispatch<SetStateAction<LotteryMode>>;
}

/**
 * Tipo do sorteio, distribuição (pesquisadores/doc, limites, subconjunto,
 * equilíbrio) e modo de atribuições pendentes. Extraído de `LotteryDialog`.
 */
export function useLotteryDistribution(): LotteryDistribution {
  const [type, setType] = useState<"codificacao" | "comparacao">("codificacao");
  const [researchersPerDoc, setResearchersPerDoc] = useState(2);
  const [docsPerResearcherEnabled, setDocsPerResearcherEnabled] =
    useState(false);
  const [docsPerResearcher, setDocsPerResearcher] = useState(10);
  const [docSubsetEnabled, setDocSubsetEnabled] = useState(false);
  const [docSubsetSize, setDocSubsetSize] = useState(50);
  const [balancing, setBalancing] = useState<LotteryBalancing>("round");
  const [mode, setMode] = useState<LotteryMode>("append");

  return {
    type,
    setType,
    isComparacao: type === "comparacao",
    researchersPerDoc,
    setResearchersPerDoc,
    docsPerResearcherEnabled,
    setDocsPerResearcherEnabled,
    docsPerResearcher,
    setDocsPerResearcher,
    docSubsetEnabled,
    setDocSubsetEnabled,
    docSubsetSize,
    setDocSubsetSize,
    balancing,
    setBalancing,
    mode,
    setMode,
  };
}
