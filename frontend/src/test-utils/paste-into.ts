import userEvent from "@testing-library/user-event";

type PasteUser = Pick<typeof userEvent, "click" | "paste">;

// Preenche um campo com uma colagem, em vez de uma tecla por caractere. Cada
// tecla do user-event dispara keydown, keypress, beforeinput, input e keyup, e
// cada input re-renderiza o formulário controlado inteiro: no EditFieldDialog
// isso custava uns 10 ms de CPU por caractere com a máquina livre, e duas a
// três vezes mais com a suíte disputando os núcleos, o que punha testes com
// uma frase digitada perto do timeout de 5 s. A colagem chega ao componente
// como um único input com o texto todo, pelo mesmo onChange.
//
// Serve ao teste que confere o valor final do campo. O teste que depende do
// que acontece entre uma tecla e outra (atalho de teclado, máscara, debounce
// contado por tecla) continua digitando.
//
// O clique vem antes porque o paste cola no elemento que tem o foco; o
// user.type também clica no campo antes de digitar.
export async function pasteInto(
  element: Element,
  text: string,
  user: PasteUser = userEvent,
): Promise<void> {
  await user.click(element);
  await user.paste(text);
}
