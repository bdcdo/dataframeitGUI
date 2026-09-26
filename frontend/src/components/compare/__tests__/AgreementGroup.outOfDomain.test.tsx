// @vitest-environment jsdom
// Card cuja resposta saiu das opções atuais da pergunta (versão minor anterior
// sob o piso `latest_major`, ou "Outro: x" depois de desligar `allow_other`):
// o voto copiaria um veredito que nasce sem validade, então o card aparece
// marcado e sem o alvo de voto.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AgreementGroup } from "@/components/compare/AgreementGroup";

afterEach(cleanup);

type Props = Parameters<typeof AgreementGroup>[0];
type Resp = Props["responses"][number];

function resp(id: string, answer: unknown): Resp {
  return { id, respondent_type: "humano", respondent_name: id, answer, is_latest: true, isFieldStale: false };
}

function renderGroup(domainField: Props["domainField"], answers: string[]) {
  const onVote = vi.fn();
  render(
    <AgreementGroup
      readOnly={false}
      responses={answers.map((a, i) => resp(`r${i}`, a))}
      existingVerdict={null}
      pendingVerdict={null}
      onVote={onVote}
      domainField={domainField}
      allowEquivalence={false}
      equivalences={[]}
      currentUserId="u1"
      canManageAnyPair={false}
      pendingConfirm={{ onConfirm: vi.fn(), onDiscard: vi.fn(), isSaving: false }}
    />,
  );
  return { onVote };
}

const voteTarget = (answer: string) =>
  screen.queryByRole("button", { name: `Selecionar esta resposta para confirmar: ${answer}` });

describe("AgreementGroup: resposta fora das opções atuais", () => {
  const single = { type: "single" as const, options: ["Sim", "Não"], allow_other: false };

  it("opção que saiu do formulário fica marcada e sem voto; a atual continua votável", () => {
    const { onVote } = renderGroup(single, ["Sim", "Talvez"]);

    expect(voteTarget("Talvez")).toBeNull();
    expect(screen.getByText("Fora das opções atuais")).toBeTruthy();
    const current = voteTarget("Sim");
    expect(current).toBeTruthy();
    current!.click();
    expect(onVote).toHaveBeenCalledWith("Sim", "r0");
  });

  it("\"Outro: x\" sem allow_other fica sem voto, e com allow_other volta a ser votável", () => {
    renderGroup(single, ["Outro: x"]);
    expect(voteTarget("Outro: x")).toBeNull();
    cleanup();

    renderGroup({ ...single, allow_other: true }, ["Outro: x"]);
    expect(voteTarget("Outro: x")).toBeTruthy();
    expect(screen.queryByText("Fora das opções atuais")).toBeNull();
  });

  it("campo sem definição não restringe o voto", () => {
    renderGroup(null, ["Talvez"]);
    expect(voteTarget("Talvez")).toBeTruthy();
  });
});
