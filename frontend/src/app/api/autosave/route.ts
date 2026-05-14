import { NextResponse } from "next/server";
import { saveResponse } from "@/actions/responses";

// Endpoint dedicado ao autosave disparado via navigator.sendBeacon no
// visibilitychange (#28). Server Actions sao requests POST que o browser pode
// abortar ao fechar a tab; sendBeacon/keepalive garantem a entrega. A auth
// continua automatica: sendBeacon envia os cookies do Clerk numa request
// same-origin, entao saveResponse() resolve o usuario normalmente.
export async function POST(request: Request) {
  // Route handlers nao tem a protecao CSRF embutida das Server Actions. O
  // autosave so e legitimo same-origin: exigimos que o header Origin exista e
  // bata com o Host. Na pratica o cookie SameSite=Lax do Clerk e o
  // Content-Type application/json (nao CORS-safelisted) ja barram o ataque
  // cross-site, mas o check torna a intencao explicita e a prova de regressao.
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) {
    return NextResponse.json({ error: "Origem invalida" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON invalido" }, { status: 400 });
  }

  if (typeof payload !== "object" || payload === null) {
    return NextResponse.json({ error: "Body invalido" }, { status: 400 });
  }

  const { projectId, documentId, answers, notes } = payload as Record<
    string,
    unknown
  >;

  if (typeof projectId !== "string" || typeof documentId !== "string") {
    return NextResponse.json(
      { error: "projectId e documentId obrigatorios" },
      { status: 400 },
    );
  }
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    return NextResponse.json({ error: "answers invalido" }, { status: 400 });
  }
  if (notes !== undefined && typeof notes !== "string") {
    return NextResponse.json({ error: "notes invalido" }, { status: 400 });
  }

  const result = await saveResponse(
    projectId,
    documentId,
    answers as Record<string, unknown>,
    { notes, isAutoSave: true },
  );

  if (!result.success) {
    // sendBeacon e fire-and-forget; o status serve para observabilidade em logs.
    // O detalhe do erro vai so para o log do server — a resposta devolve uma
    // mensagem generica para nao vazar mensagens cruas do Postgres.
    console.error("[autosave] falhou:", result.error);
    return NextResponse.json({ error: "Falha ao salvar" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
