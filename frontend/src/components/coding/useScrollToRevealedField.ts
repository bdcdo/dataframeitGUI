import { useEffect, useRef, type RefObject } from "react";
import { getScrollBehavior } from "@/lib/scroll";
import type { PydanticField } from "@/lib/types";

/**
 * Quando uma resposta libera uma pergunta condicional, o DOM atualiza
 * in-place e o scroll fica parado — o pesquisador pode não perceber a nova
 * pergunta fora da viewport. Detecta o campo condicional que passou de
 * invisível para visível e rola suavemente até ele.
 */
export function useScrollToRevealedField(
  visibleFields: PydanticField[],
  visibleNames: Set<string>,
  allNamesKey: string,
  readOnly: boolean,
  questionRefs: RefObject<(HTMLDivElement | null)[]>,
): void {
  // Conjunto de nomes visíveis no render anterior — detecta condicionais que
  // acabaram de aparecer. `null` até o 1º effect (semeado lá dentro, nunca no
  // corpo do render — escrita de ref durante o render não é concurrent-safe).
  const prevVisibleNamesRef = useRef<Set<string> | null>(null);
  // Assinatura order-independent do conjunto de TODOS os campos. Só muda quando
  // um campo é adicionado/removido (mudança de schema). Reorder e o load
  // assíncrono de `fieldOrder` reordenam mas não mudam o conjunto, então não
  // suprimem um scroll legítimo (ver #252); a comparação por identidade da prop
  // `fields` suprimia-os por engano.
  const prevAllNamesKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const firstRun = prevVisibleNamesRef.current === null;
    const prev = prevVisibleNamesRef.current ?? visibleNames;
    prevVisibleNamesRef.current = visibleNames;
    const structuralChange =
      prevAllNamesKeyRef.current !== null &&
      prevAllNamesKeyRef.current !== allNamesKey;
    prevAllNamesKeyRef.current = allNamesKey;

    if (firstRun) return; // mount: semeia os refs e não rola
    if (structuralChange) return; // add/remove de campo (schema), não resposta
    if (readOnly) return;

    const newIdx = visibleFields.findIndex(
      (f) => f.condition && !prev.has(f.name),
    );
    if (newIdx < 0) return;

    questionRefs.current[newIdx]?.scrollIntoView({
      behavior: getScrollBehavior(),
      block: "center",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleNames]);
}
