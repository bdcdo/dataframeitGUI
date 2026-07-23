// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SubmitBar } from "@/components/coding/SubmitBar";

afterEach(cleanup);

// Estado default do rodapé: nada bloqueando e sem pendências. Cada teste vira
// só o eixo que exercita, para que a PRECEDÊNCIA fique explícita — a mesma
// ordem que o pesquisador enxerga: fora do escopo > leitura > salvando >
// pendências > normal.
const base = {
  outOfScopeBlocked: false,
  readOnly: false,
  submitting: false,
  missingRequiredCount: 0,
  onClick: () => {},
};

describe("SubmitBar — precedência de estados", () => {
  it("normal: envia respostas, habilitado", () => {
    render(<SubmitBar {...base} />);
    const btn = screen.getByRole("button", { name: /Enviar respostas/ });
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("pendência (plural): reporta a contagem e mantém o botão habilitado", () => {
    // O botão segue clicável de propósito: quem clica recebe o destaque e o
    // scroll até o primeiro campo em branco (a validação vive em
    // useQuestionValidation, não no disabled do botão).
    render(<SubmitBar {...base} missingRequiredCount={3} />);
    const btn = screen.getByRole("button", { name: /Faltam 3 obrigatórias/ });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("pendência (singular): 1 obrigatória", () => {
    render(<SubmitBar {...base} missingRequiredCount={1} />);
    expect(screen.getByRole("button", { name: /Falta 1 obrigatória/ })).toBeTruthy();
  });

  it("salvando vence pendência: mostra o estado de salvamento e desabilita", () => {
    render(<SubmitBar {...base} submitting missingRequiredCount={2} />);
    const btn = screen.getByRole("button", { name: /Salvando/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Faltam/ })).toBeNull();
  });

  it("somente leitura vence salvando e pendência", () => {
    render(<SubmitBar {...base} readOnly submitting missingRequiredCount={2} />);
    const btn = screen.getByRole("button", { name: /Somente leitura/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("fora do escopo vence tudo, inclusive pendência", () => {
    render(
      <SubmitBar
        {...base}
        outOfScopeBlocked
        readOnly
        submitting
        missingRequiredCount={2}
      />,
    );
    const btn = screen.getByRole("button", { name: /Aguardando revisão do coordenador/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("clique com pendência dispara onClick (validação é do caller, não do disabled)", () => {
    const onClick = vi.fn();
    render(<SubmitBar {...base} missingRequiredCount={2} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /Faltam 2 obrigatórias/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
