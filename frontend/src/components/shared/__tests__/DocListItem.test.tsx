// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DocListItem, DocListDoneIcon } from "../DocListItem";

afterEach(cleanup);

describe("DocListItem", () => {
  it("dispara onClick ao clicar no botão", () => {
    const onClick = vi.fn();
    render(
      <ul>
        <DocListItem
          icon={<span data-testid="icon" />}
          title="Meu título"
          isCurrent={false}
          onClick={onClick}
        >
          <span>badge</span>
        </DocListItem>
      </ul>,
    );
    fireEvent.click(screen.getByText("Meu título").closest("button")!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("aplica a classe de destaque quando isCurrent=true", () => {
    render(
      <ul>
        <DocListItem
          icon={<span data-testid="icon" />}
          title="Meu título"
          isCurrent
          onClick={vi.fn()}
        >
          <span>badge</span>
        </DocListItem>
      </ul>,
    );
    const button = screen.getByText("Meu título").closest("button")!;
    expect(button.className).toContain("bg-brand/10");
  });

  it("não aplica a classe de destaque quando isCurrent=false", () => {
    render(
      <ul>
        <DocListItem
          icon={<span data-testid="icon" />}
          title="Meu título"
          isCurrent={false}
          onClick={vi.fn()}
        >
          <span>badge</span>
        </DocListItem>
      </ul>,
    );
    const button = screen.getByText("Meu título").closest("button")!;
    expect(button.className).not.toContain("bg-brand/10");
  });

  it("renderiza title como texto e como atributo do span", () => {
    render(
      <ul>
        <DocListItem
          icon={<span data-testid="icon" />}
          title="Meu título"
          isCurrent={false}
          onClick={vi.fn()}
        >
          <span>badge</span>
        </DocListItem>
      </ul>,
    );
    const titleSpan = screen.getByText("Meu título");
    expect(titleSpan.getAttribute("title")).toBe("Meu título");
  });

  it("renderiza children (badges) dentro do wrapper de badges", () => {
    render(
      <ul>
        <DocListItem
          icon={<span data-testid="icon" />}
          title="Meu título"
          isCurrent={false}
          onClick={vi.fn()}
        >
          <span>badge-de-teste</span>
        </DocListItem>
      </ul>,
    );
    expect(screen.getByText("badge-de-teste")).toBeTruthy();
  });
});

describe("DocListDoneIcon", () => {
  it("renderiza CheckCircle2 quando isDone=true", () => {
    const { container } = render(<DocListDoneIcon isDone />);
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("class")).toContain("text-green-600");
  });

  it("renderiza Circle quando isDone=false", () => {
    const { container } = render(<DocListDoneIcon isDone={false} />);
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("class")).toContain("text-muted-foreground/50");
  });
});
