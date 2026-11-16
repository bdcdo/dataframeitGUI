// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { RunProgress } from "@/components/llm/RunProgress";

beforeAll(() => warmUpJsdom(), 30_000);
afterEach(cleanup);

describe("RunProgress", () => {
  // A fila contínua (#830) não divide a rodada em lotes de documentos, então o
  // rótulo "Lote x/y" saiu da tela (#832). O backend antigo ainda pode mandar
  // os dois campos durante um deploy; a tela os ignora.
  it("mostra fase, contagem e ETA do processamento, sem rótulo de lote", () => {
    const legacyPayload = { currentBatch: 2, totalBatches: 5 };
    render(
      <RunProgress
        phase="processing"
        progress={3}
        total={10}
        etaSeconds={90}
        processedComplete={2}
        processedPartial={1}
        processedEmpty={0}
        {...legacyPayload}
      />,
    );

    expect(screen.getByText("Processando")).toBeTruthy();
    expect(screen.getByText("3/10 documentos processados")).toBeTruthy();
    expect(screen.getByText("~1min 30s restantes")).toBeTruthy();
    expect(screen.queryByText(/Lote/)).toBeNull();
  });
});
