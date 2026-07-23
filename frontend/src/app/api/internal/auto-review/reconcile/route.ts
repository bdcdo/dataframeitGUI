import { NextResponse } from "next/server";
import { drainAutoReviewReconciliationRequests } from "@/lib/auto-review-reconciler";
import { isAutoReviewReconciliationBearer } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAutoReviewReconciliationBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  try {
    const result = await drainAutoReviewReconciliationRequests();
    return NextResponse.json(result, { status: result.failed > 0 ? 503 : 200 });
  } catch (error) {
    console.error(
      `[auto-review] ${JSON.stringify({
        event: "reconciliation_drain_failed",
        error: error instanceof Error ? error.message : String(error),
      })}`,
    );
    return NextResponse.json(
      { error: "Falha ao reconciliar a fila de auto-revisão" },
      { status: 500 },
    );
  }
}
