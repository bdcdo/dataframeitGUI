import { NextResponse } from "next/server";
import { saveResponse } from "@/actions/responses";

// Endpoint dedicado ao autosave disparado via navigator.sendBeacon no
// visibilitychange (#28). Server Actions sao requests POST que o browser pode
// abortar ao fechar a tab; sendBeacon/keepalive garantem a entrega. A auth
// continua automatica: sendBeacon envia os cookies do Clerk numa request
// same-origin, entao saveResponse() resolve o usuario normalmente.
export async function POST(request: Request) {
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
    console.error("[autosave] falhou:", result.error);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
