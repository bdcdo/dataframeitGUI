"use client";

import { useSyncExternalStore, type ComponentProps } from "react";
import { SignIn as ClerkSignIn } from "@clerk/nextjs";

// Componentes de UI do Clerk só depois da hidratação.
//
// Os componentes de UI do `@clerk/react` (`SignIn`, `UserButton`, …) decidem o
// que renderizar lendo `clerk.loaded` DURANTE o render, e esse `loaded` é um
// getter que consulta o clerk-js ao vivo (`IsomorphicClerk.loaded`), não um
// snapshot de estado do React. No servidor ele é sempre `false`, e o `SignIn`
// sai vazio no HTML. No cliente, o clerk-js começa a carregar quando o
// `ClerkProvider` do layout hidrata; se o carregamento terminar antes de o React
// chegar ao `SignIn`, o primeiro render do cliente já vê `loaded === true` e
// emite o `<div data-clerk-component="SignIn">` que o servidor não emitiu. O
// React acusa "Hydration failed" e regenera a árvore. É uma corrida entre a rede
// do clerk-js e o ritmo da hidratação: com a CPU ocupada (máquina carregada, ou
// a CPU estrangulada no DevTools) a hidratação demora e o erro aparece em boa
// parte das cargas de `/auth/login`; com a CPU livre, quase nunca.
//
// O portão abaixo faz o primeiro render do cliente repetir o do servidor (nada) e
// só monta o componente do Clerk no render seguinte, já fora da hidratação. Não
// há perda: o servidor nunca renderiza esses componentes, porque lá o Clerk nunca
// está carregado.
//
// `useSyncExternalStore` com snapshot de servidor `false` e de cliente `true` é a
// forma de o React expressar "estou hidratando": durante a hidratação ele usa o
// snapshot de servidor e, logo depois, re-renderiza com o do cliente. O
// `useEffect` + `setState` equivalente custaria um disable de
// `react-hooks/set-state-in-effect`.
//
// O `eslint.config.mjs` proíbe importar os componentes de UI do Clerk direto de
// `@clerk/nextjs` fora deste arquivo; quem precisar de outro (ex.: `UserButton`)
// o embrulha aqui com o mesmo portão.

function subscribeNever(): () => void {
  return () => {};
}

function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

export function SignIn(props: ComponentProps<typeof ClerkSignIn>) {
  const hydrated = useHydrated();
  return hydrated ? <ClerkSignIn {...props} /> : null;
}
